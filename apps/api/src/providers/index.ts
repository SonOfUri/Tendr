import { env } from '../env.js';
import { providerNotConfigured } from '../lib/errors.js';
import { NearIntentsProvider } from './near-intents.js';
import { SandboxPaymentProvider } from './sandbox.js';
import type { PaymentProvider, PaymentVerifier, QuoteProvider } from './types.js';

export function getProviders(): {
  quotes: QuoteProvider;
  payments: PaymentProvider;
  verifier: PaymentVerifier;
} {
  const e = env();
  if (e.PAYMENT_PROVIDER === 'sandbox') {
    const sandbox = new SandboxPaymentProvider();
    return { quotes: sandbox, payments: sandbox, verifier: sandbox };
  }
  if (e.PAYMENT_PROVIDER === 'near_intents') {
    if (!e.CHECKOUT_LIVE_ENABLED) {
      throw providerNotConfigured('near_intents requires CHECKOUT_LIVE_ENABLED=true');
    }
    const near = new NearIntentsProvider();
    return { quotes: near, payments: near, verifier: near };
  }
  throw providerNotConfigured(`Unknown PAYMENT_PROVIDER: ${e.PAYMENT_PROVIDER}`);
}

export * from './types.js';
export { SandboxPaymentProvider } from './sandbox.js';
export { NearIntentsProvider } from './near-intents.js';
