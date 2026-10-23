import { TendrClient } from '@tendr/sdk';
import { serverEnv } from './env';

export function getServerTendrClient() {
  const env = serverEnv();
  if (!env.demoMerchantApiKey) {
    throw new Error(
      'DEMO_MERCHANT_API_KEY is not set. Run `pnpm db:seed` and add the printed key to .env',
    );
  }
  return new TendrClient({
    baseUrl: env.apiBaseUrl,
    apiKey: env.demoMerchantApiKey,
  });
}
