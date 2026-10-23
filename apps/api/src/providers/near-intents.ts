import { env } from '../env.js';
import { providerNotConfigured } from '../lib/errors.js';
import type {
  PaymentProvider,
  PaymentStartResult,
  PaymentVerifier,
  PaymentVerifyResult,
  QuoteProvider,
  QuoteRequest,
  QuoteResult,
} from './types.js';

/**
 * Adapter boundary for NEAR Intents.
 *
 * TODO: Before implementing live calls, consult official docs:
 * https://docs.near-intents.org/
 * Record exact API versions, request/response examples, supported assets/networks,
 * and limitations in apps/docs/integrations/near-intents.mdx (and an ADR).
 * Do not invent endpoints, payload fields, or guarantees.
 */
export class NearIntentsProvider implements QuoteProvider, PaymentProvider, PaymentVerifier {
  readonly name = 'near_intents';

  private assertConfigured(): never {
    const e = env();
    if (!e.CHECKOUT_LIVE_ENABLED) {
      throw providerNotConfigured(
        'Live checkout is disabled. Set CHECKOUT_LIVE_ENABLED=true only after a real provider is ready.',
      );
    }
    if (!e.NEAR_INTENTS_API_BASE_URL || !e.NEAR_INTENTS_API_KEY) {
      throw providerNotConfigured(
        'NEAR Intents credentials are not configured. See https://docs.near-intents.org/',
      );
    }
    throw providerNotConfigured(
      'NearIntentsProvider methods are not implemented. Consult https://docs.near-intents.org/',
    );
  }

  async createQuote(_input: QuoteRequest): Promise<QuoteResult> {
    return this.assertConfigured();
  }

  async startPayment(_input: {
    sessionId: string;
    quoteId: string;
    amount: string;
    currency: string;
  }): Promise<PaymentStartResult> {
    return this.assertConfigured();
  }

  async verify(_providerReference: string): Promise<PaymentVerifyResult> {
    return this.assertConfigured();
  }
}
