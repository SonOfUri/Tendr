import { randomBytes } from 'node:crypto';
import type {
  PaymentProvider,
  PaymentVerifier,
  QuoteProvider,
  QuoteRequest,
  QuoteResult,
} from './types.js';

/**
 * Deterministic sandbox provider. Never enable as "live".
 */
export class SandboxPaymentProvider implements QuoteProvider, PaymentProvider, PaymentVerifier {
  readonly name = 'sandbox';

  async createQuote(input: QuoteRequest): Promise<QuoteResult> {
    const sourceAsset = input.sourceAsset ?? 'USDC';
    const sourceNetwork = input.sourceNetwork ?? 'near';
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    return {
      sourceAsset,
      sourceNetwork,
      destinationAsset: input.currency,
      destinationNetwork: 'tendr-settlement',
      sourceAmount: input.amount,
      destinationAmount: input.amount,
      expiresAt,
      provider: this.name,
    };
  }

  async startPayment(input: {
    sessionId: string;
    quoteId: string;
    amount: string;
    currency: string;
  }) {
    return {
      providerReference: `sandbox_${input.sessionId}_${randomBytes(4).toString('hex')}`,
    };
  }

  async verify(providerReference: string) {
    // Sandbox settles on verify for demo flows after confirm moves to PROCESSING.
    if (!providerReference.startsWith('sandbox_')) {
      return {
        status: 'FAILED' as const,
        providerReference,
        failureReason: 'Unknown sandbox reference',
      };
    }
    return { status: 'SETTLED' as const, providerReference };
  }
}
