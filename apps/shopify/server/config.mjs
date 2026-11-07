import { readFileSync } from 'node:fs';

export function loadConfig(env = process.env) {
  const simulated = env.SHOPIFY_SIMULATOR === 'true';
  const required = (name) => {
    if (!env[name]) throw new Error(`Missing ${name}`);
    return env[name];
  };
  const origin = new URL(required('SHOPIFY_APP_URL'));
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw new Error('SHOPIFY_APP_URL must be an origin');
  const key = Buffer.from(required('SHOPIFY_STORAGE_KEY'), 'hex');
  if (!/^[a-f\d]{64}$/i.test(env.SHOPIFY_STORAGE_KEY) || key.length !== 32)
    throw new Error('SHOPIFY_STORAGE_KEY must contain 32 random bytes encoded as hex');
  const shop =
    env.SHOPIFY_SHOP || (simulated ? 'tendr-simulator.myshopify.com' : required('SHOPIFY_SHOP'));
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Invalid SHOPIFY_SHOP');
  const config = {
    simulated,
    testOnly: env.SHOPIFY_TEST_ONLY !== 'false',
    origin: origin.origin,
    shop,
    key,
    database: env.SHOPIFY_DATABASE || './data/shopify.sqlite',
    port: Number(env.PORT || 3355),
    apiVersion: '2026-10',
    apiKey: env.SHOPIFY_API_KEY,
    apiSecret: env.SHOPIFY_API_SECRET,
    tendrUrl: env.TENDR_API_URL || 'https://api.usetendr.tech',
    checkoutOrigin: env.TENDR_CHECKOUT_ORIGIN || 'https://pay.usetendr.tech',
    externalHandle: env.TENDR_STORE_HANDLE || 'Tendr',
    modes: {
      test: { key: env.TENDR_TEST_SECRET_KEY, webhook: env.TENDR_TEST_WEBHOOK_SECRET },
      live: { key: env.TENDR_LIVE_SECRET_KEY, webhook: env.TENDR_LIVE_WEBHOOK_SECRET },
    },
  };
  if (simulated) {
    if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname))
      throw new Error('Simulator must use a loopback HTTP origin');
    if (
      Object.values(config.modes).some((mode) => mode.key || mode.webhook) ||
      config.apiSecret ||
      config.apiKey
    )
      throw new Error('Never provide real credentials to the simulator');
    config.modes.test = { key: 'simulated', webhook: key.toString('hex') };
  } else {
    if (origin.protocol !== 'https:') throw new Error('Shopify requires HTTPS');
    required('SHOPIFY_API_KEY');
    required('SHOPIFY_API_SECRET');
    for (const url of [config.tendrUrl, config.checkoutOrigin]) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
      )
        throw new Error('Tendr endpoints must be HTTPS origins');
    }
    for (const [mode, values] of Object.entries(config.modes)) {
      if (Boolean(values.key) !== Boolean(values.webhook))
        throw new Error(`Provide both ${mode} credentials`);
      if (values.key && !values.key.startsWith(`tdr_${mode}_`))
        throw new Error(`Wrong ${mode} secret key prefix`);
    }
    if (!config.modes.test.key)
      throw new Error('Test credentials are required before connecting Shopify');
    config.tls = {
      key: readFileSync(required('SHOPIFY_TLS_KEY')),
      cert: readFileSync(required('SHOPIFY_TLS_CERT')),
      ca: readFileSync(required('SHOPIFY_CLIENT_CA')),
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    };
  }
  return config;
}
