/**
 * The single place event handlers are registered. The worker imports this module before it
 * starts, so its dispatcher sees every handler: an event type with no handler registered here is
 * dropped from the outbox without being delivered (it stays in `events`).
 *
 * Handlers arrive in later projects, e.g.:
 *   registerEventHandler('payment.settled', 'webhook-delivery', deliverWebhook);
 */
export {};
