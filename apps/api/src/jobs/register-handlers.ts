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
import { registerWatcherHooks } from '../checkout/watcher.js';
import { registerAccountHandlers } from './account-notices.js';
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
