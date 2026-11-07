import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequestHandler } from '@react-router/express';
import express from 'express';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { realProviders } from './clients.mjs';
import { simulatedProviders } from './simulator.mjs';
import { createApp, errorHandler } from './http.mjs';

process.umask(0o077);
const config = loadConfig();
const store = new Store(config.database, config.key);
const providers = config.simulated
  ? simulatedProviders(config, store)
  : realProviders(config, store);
const engine = new Engine(config, store, providers);
const { app, context } = createApp(config, store, engine, providers);
if (process.env.NODE_ENV === 'production') {
  app.use('/assets', express.static('build/client/assets', { immutable: true, maxAge: '1y' }));
  app.use(express.static('build/client', { maxAge: '1h' }));
  const build = await import('../build/server/index.js');
  app.all('*', createRequestHandler({ build, getLoadContext: () => context, mode: 'production' }));
} else {
  const vite = await (
    await import('vite')
  ).createServer({ server: { middlewareMode: true }, appType: 'custom' });
  app.use(vite.middlewares);
  app.all(
    '*',
    createRequestHandler({
      build: () => vite.ssrLoadModule('virtual:react-router/server-build'),
      getLoadContext: () => context,
    }),
  );
}
app.use(errorHandler);
const server = config.simulated ? createHttpServer(app) : createHttpsServer(config.tls, app);
server.requestTimeout = 60_000;
server.listen(config.port, '0.0.0.0', () =>
  console.log(
    `Tendr Shopify ${config.simulated ? 'SIMULATOR' : 'connector'} listening on port ${config.port}`,
  ),
);
let working = false;
const timer = setInterval(async () => {
  if (working) return;
  working = true;
  try {
    await engine.tick();
  } catch {
    console.error('Shopify reconciliation needs attention');
  } finally {
    working = false;
  }
}, 3000);
async function shutdown() {
  clearInterval(timer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
