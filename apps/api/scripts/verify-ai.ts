/** Three real model calls with synthetic data only. No checkout/theme records or funds are changed. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';
import { loadEnv } from '../src/env.js';
import { prisma } from '../src/lib/prisma.js';
import { AppError } from '../src/lib/errors.js';
import { providerConfig, httpFactSelector, httpJsonGenerator } from '../src/ai/provider.js';
import { themeGenerationRequest, validateThemeProposal } from '../src/ai/theme-drafts.js';

loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));

async function main() {
  loadEnv();
  const config = await providerConfig();
  console.log(
    JSON.stringify({ provider: config.provider, model: config.model, synthetic_data: true }),
  );
  const start = Date.now();
  const checkout = await httpFactSelector(config)('Has my payment completed?', [
    { id: 'status', text: 'This test checkout is waiting for payment. It has not settled.' },
    { id: 'refunds', text: 'There are no refund records.' },
    { id: 'capabilities', text: 'I can explain the payment state but cannot move funds.' },
    { id: 'unsupported', text: 'Contact the store for order or delivery questions.' },
  ]);
  if (!checkout.includes('status')) throw new Error('Checkout selector omitted payment status');
  console.log(JSON.stringify({ check: 'checkout_assistant', passed: true }));
  const insights = await httpFactSelector(
    config,
    fetch,
    'insights',
  )('What is my conversion?', [
    { id: 'scope', text: 'Synthetic test-mode checkout session cohort.' },
    { id: 'conversion', text: '2 of 10 sessions settled; conversion is 20.00%.' },
    { id: 'unsupported', text: 'These totals do not prove why shoppers left.' },
  ]);
  if (!insights.includes('conversion')) throw new Error('Insight selector omitted conversion');
  console.log(JSON.stringify({ check: 'merchant_insights', passed: true }));
  const proposal = await httpJsonGenerator(config)(
    themeGenerationRequest(
      'A dark checkout with violet accents, soft corners and highly readable text. No custom CSS.',
    ),
  );
  validateThemeProposal(proposal, 'Synthetic verification store');
  console.log(JSON.stringify({ check: 'theme_validation', passed: true, saved: false }));
  console.log(
    JSON.stringify({
      passed: true,
      calls: 3,
      elapsed_ms: Date.now() - start,
      attestation_verified: false,
      end_to_end_encryption: false,
    }),
  );
}

main()
  .catch((error: unknown) => {
    // Never print raw provider errors, bodies, prompts, or credentials.
    console.error(
      JSON.stringify({
        passed: false,
        code: error instanceof AppError ? error.code : 'VERIFICATION_FAILED',
        details: error instanceof AppError ? error.details : undefined,
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
