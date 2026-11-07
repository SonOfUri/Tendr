import express from 'express';
import { createCookie, redirect, redirectDocument } from 'react-router';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LogSeverity } from '@shopify/shopify-api';
import { RequestError } from './engine.mjs';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export function verifyShopifyHmac(body, signature, secret) {
  const expected = createHmac('sha256', secret).update(body).digest();
  const provided = Buffer.from(signature || '', 'base64');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
export function requireMtls(req, config) {
  if (!req.socket.encrypted || req.socket.authorized !== true)
    throw new RequestError(401, 'shopify_client_certificate_required');
  if (req.get('Shopify-Shop-Domain') !== config.shop)
    throw new RequestError(403, 'shop_not_configured');
  if (req.get('Shopify-Api-Version') !== config.apiVersion || !req.get('Shopify-Request-Id'))
    throw new RequestError(400, 'invalid_shopify_headers');
}
export function sameOrigin(request, config) {
  if (request.headers.get('Origin') !== config.origin)
    throw new RequestError(403, 'invalid_origin');
}

export function createApp(config, store, engine, providers) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    // Blocks DNS rebinding against the unauthenticated local simulator.
    if (config.simulated && req.get('host') !== new URL(config.origin).host)
      return res.status(403).json({ error: 'invalid_host' });
    next();
  });
  const cookie = createCookie('__tendr_shopify', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !config.simulated,
    maxAge: 3600,
    secrets: [createHmac('sha256', config.key).update('admin-cookie').digest('hex')],
  });
  const sdk = config.simulated
    ? null
    : shopifyApi({
        apiKey: config.apiKey,
        apiSecretKey: config.apiSecret,
        scopes: ['write_payment_gateways', 'write_payment_sessions'],
        hostName: new URL(config.origin).host,
        hostScheme: 'https',
        apiVersion: config.apiVersion,
        isEmbeddedApp: false,
        logger: { level: LogSeverity.Error, log: () => {} },
      });
  const context = {
    config,
    store,
    engine,
    providers,
    checkOrigin: (request) => sameOrigin(request, config),
    async requireAdmin(request) {
      if (config.simulated) return;
      const token = await cookie.parse(request.headers.get('Cookie'));
      const admin = store.get('admin');
      if (
        !token ||
        typeof token !== 'string' ||
        !admin ||
        admin.expires < Date.now() ||
        createHash('sha256').update(token).digest('hex') !== admin.hash ||
        !store.get('oauth')
      )
        throw redirectDocument(`/auth?shop=${encodeURIComponent(config.shop)}`);
    },
    async action(request) {
      await context.requireAdmin(request);
      sameOrigin(request, config);
      const data = await request.formData();
      const action = data.get('action');
      if (action === 'configure' && !config.simulated) {
        const ready = data.get('ready') === 'true';
        if (ready && !config.testOnly && !config.modes.live.key)
          throw new RequestError(409, 'live_credentials_required_for_ready');
        await providers.configure(ready);
        store.set('ready', ready);
        return redirect('/app');
      }
      if (!config.simulated) throw new RequestError(404, 'not_found');
      if (action === 'create') {
        const id = randomUUID();
        const result = await engine.accept('payment', {
          id,
          gid: `gid://shopify/PaymentSession/${id}`,
          amount: data.get('amount'),
          currency: 'USD',
          test: true,
          kind: 'sale',
          payment_method: { type: 'offsite' },
        });
        return redirectDocument(result.redirect_url);
      }
      const op = store.byToken(data.get('token'));
      if (!op) throw new RequestError(404, 'not_found');
      if (action === 'refund' && op.kind === 'payment') {
        const id = randomUUID();
        await engine.accept('refund', {
          id,
          gid: `gid://shopify/RefundSession/${id}`,
          payment_id: op.input.id,
          amount: data.get('amount'),
          currency: op.input.currency,
          test: true,
        });
      } else if (action === 'approve-refund' && op.kind === 'refund')
        await providers.transition(engine, op, action);
      else throw new RequestError(400, 'invalid_action');
      return redirect('/app');
    },
  };
  app.get('/favicon.ico', (_req, res) => res.sendStatus(204));
  app.get('/health', (_req, res) => res.json({ ok: true, simulator: config.simulated }));
  app.get(
    '/auth',
    wrap(async (req, res) => {
      if (!sdk) return res.redirect('/app');
      if (req.query.shop !== config.shop) throw new RequestError(403, 'shop_not_configured');
      await sdk.auth.begin({
        shop: config.shop,
        callbackPath: '/auth/callback',
        isOnline: false,
        rawRequest: req,
        rawResponse: res,
      });
    }),
  );
  app.get(
    '/auth/callback',
    wrap(async (req, res) => {
      if (!sdk || req.query.shop !== config.shop)
        throw new RequestError(403, 'shop_not_configured');
      const { session } = await sdk.auth.callback({
        rawRequest: req,
        rawResponse: res,
        expiring: false,
      });
      if (
        session.shop !== config.shop ||
        session.isOnline ||
        !session.accessToken ||
        !session.isScopeIncluded(['write_payment_gateways', 'write_payment_sessions'])
      )
        throw new RequestError(403, 'payments_permissions_required');
      store.set('oauth', session.toObject());
      const token = randomBytes(32).toString('base64url');
      store.set('admin', {
        hash: createHash('sha256').update(token).digest('hex'),
        expires: Date.now() + 3600_000,
      });
      res.append('Set-Cookie', await cookie.serialize(token));
      res.redirect('/app');
    }),
  );
  app.post(
    '/webhooks/shopify/uninstalled',
    express.raw({ type: 'application/json', limit: '256kb' }),
    wrap(async (req, res) => {
      if (
        !config.apiSecret ||
        !Buffer.isBuffer(req.body) ||
        !verifyShopifyHmac(req.body, req.get('X-Shopify-Hmac-Sha256'), config.apiSecret)
      )
        throw new RequestError(401, 'invalid_webhook_signature');
      if (
        req.get('X-Shopify-Shop-Domain') !== config.shop ||
        req.get('X-Shopify-Topic') !== 'app/uninstalled'
      )
        throw new RequestError(403, 'invalid_shopify_webhook');
      const body = JSON.parse(req.body.toString());
      if (body.myshopify_domain !== config.shop) throw new RequestError(403, 'shop_not_configured');
      store.delete('oauth');
      store.delete('admin');
      store.set('ready', false);
      res.sendStatus(204);
    }),
  );
  app.post(
    '/webhooks/tendr/:mode',
    express.raw({ type: 'application/json', limit: '256kb' }),
    wrap(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw new RequestError(400, 'expected_json');
      await engine.webhook(req.params.mode, req.body, req.get('Tendr-Signature'));
      res.sendStatus(204);
    }),
  );
  for (const kind of ['payment', 'refund']) {
    app.post(
      `/${kind}s/session`,
      express.json({ limit: '64kb' }),
      wrap(async (req, res) => {
        // Simulator orders enter through its CSRF-protected UI, never this mTLS boundary.
        requireMtls(req, config);
        if (!store.get('oauth')) throw new RequestError(403, 'app_not_installed');
        res.status(201).json(await engine.accept(kind, req.body));
      }),
    );
  }
  app.get('/checkout/:token', (req, res) => {
    const op = store.byToken(req.params.token);
    if (!op || op.kind !== 'payment' || !op.checkoutUrl) return res.sendStatus(404);
    res.redirect(303, op.done ? `/return/${op.token}` : op.checkoutUrl);
  });
  return { app, context };
}
export function errorHandler(error, _req, res, _next) {
  // Never echo provider bodies, tokens, checkout URLs, OAuth query strings or PII.
  const status = error instanceof RequestError ? error.status : error.status === 413 ? 413 : 500;
  res.status(status).json({ error: error instanceof RequestError ? error.code : 'request_failed' });
}
