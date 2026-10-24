/**
 * The single place event handlers are registered. The worker imports this module before it
 * starts, so its dispatcher sees every handler: outbox rows of an event type with no handler
 * registered here are left in the outbox (never dropped) until a release that handles them runs.
 *
 * Handlers arrive in later projects, e.g.:
 *   registerEventHandler('payment.settled', 'webhook-delivery', deliverWebhook);
 */
export {};
