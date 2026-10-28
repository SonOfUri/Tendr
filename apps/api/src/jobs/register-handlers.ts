/**
 * The single place event handlers are registered. The worker imports this module before it
 * starts, so its dispatcher sees every handler: outbox rows of an event type with no handler
 * registered here are left in the outbox (never dropped) until a release that handles them runs.
 */
import {
  PROVISION_HANDLER,
  PROVISION_JOB_OPTIONS,
  PROVISION_REQUESTED,
  provisionMerchantAccount,
} from '../accounts/accounts.js';
import { registerRefundHooks } from '../checkout/refunds.js';
import { registerWatcherHooks } from '../checkout/watcher.js';
import { registerWebhookHandlers } from '../checkout/webhooks.js';
import { registerHookHandlers } from '../hooks/hooks.js';
import { registerAccountHandlers } from './account-notices.js';
import { registerNotificationEmailNotices } from './notification-email-notices.js';
import { registerPaymentNotices } from './payment-notices.js';
import { registerReviewNotices } from './review-notices.js';
import { registerEventHandler } from './handlers.js';

// Merchant-account provisioning (test account at store creation, live account at go-live).
// Throwing makes BullMQ retry; a replay on an active account is a no-op.
registerEventHandler(
  PROVISION_REQUESTED,
  PROVISION_HANDLER,
  async (event) => {
    if (!event.merchantId || event.livemode === null) {
      throw new Error(`event ${event.id} has no merchant/mode`);
    }
    await provisionMerchantAccount(event.merchantId, event.livemode);
  },
  PROVISION_JOB_OPTIONS,
);

// Merchant-account notices to signers (built from the on-chain action) and the live → test
// signer mirror.
registerAccountHandlers();

// Payment watcher: a SCREENING_PENDING payment that screens `allow` re-runs settlement.
registerWatcherHooks();

// Return to sender: the watcher's `onReturnNeeded` hook queues refund drafts; executed / failed
// refund proposals complete or flag the return.
registerRefundHooks();

// Merchant webhooks: each merchant-facing checkout event fans out to the store's endpoints of its
// mode (internal ops events are never delivered — ruling C23).
registerWebhookHandlers();

// Review-queue signer emails (Ruling C23): payment.held, payment.screening_unresolved and
// refund.needs_review — internal ops events mailed to signers once per event, never webhooks.
registerReviewNotices();

// Store emails (WooCommerce plugin spec §8): "You got paid" on payment.succeeded and "Refund sent"
// on refund.sent, to the store's verified notification email (or its owners), once per event.
registerPaymentNotices();

// The store's notification email (W16): the verify link and the change warnings, after commit.
registerNotificationEmailNotices();

// Integrator hooks (gasless spec §4): a HOOK session's settled payment gets its contract call
// (`onTendrDeposit` / `on_tendr_deposit`), and `hook.failed` mails the store once.
registerHookHandlers();
