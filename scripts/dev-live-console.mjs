// A loopback-only frontend for the deployed API. No local API, worker, database or simulator.
// Chrome maps only the app origin to this server in a separate persistent browser profile.
// The certificate exception is pinned to this local key, never a blanket TLS exception.
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.umask(0o077);
const configPath = resolve(root, '.keyvault/live-console.json');
if (!existsSync(configPath))
  throw new Error(
    'Missing .keyvault/live-console.json. See docs/api-console.md, Live API locally.',
  );
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const app = new URL(config.WEB_URL);
const api = new URL(config.NEXT_PUBLIC_API_BASE_URL);
const checkout = new URL(config.CHECKOUT_BASE_URL);
for (const url of [app, api, checkout])
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== `${url.origin}/`)
    throw new Error('Live console URLs must be plain HTTPS origins.');
if (app.port || app.hostname === api.hostname || app.hostname === checkout.hostname)
  throw new Error('The app must have its own HTTPS host on the default port.');
const rpId = config.NEXT_PUBLIC_WEBAUTHN_RP_ID;
if (typeof rpId !== 'string' || !(app.hostname === rpId || app.hostname.endsWith(`.${rpId}`)))
  throw new Error('The app host must belong to the deployed WebAuthn RP ID.');
if (typeof config.WEB_INTERNAL_TOKEN !== 'string' || config.WEB_INTERNAL_TOKEN.length < 32)
  throw new Error('The deployed WEB_INTERNAL_TOKEN is required for server-side checkout reads.');
const port = Number(process.env.LIVE_CONSOLE_PORT ?? 3343);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('LIVE_CONSOLE_PORT must be a valid unprivileged port.');
const privateDir = resolve(root, '.keyvault/live-console');
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const keyFile = resolve(privateDir, 'localhost-key.pem');
const certFile = resolve(privateDir, 'localhost-cert.pem');
const profile = resolve(privateDir, 'chrome');
const chrome =
  process.env.LIVE_CONSOLE_CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

const renew =
  !existsSync(certFile) ||
  Date.parse(new X509Certificate(readFileSync(certFile)).validTo) < Date.now() + 86_400_000;
if (renew || !existsSync(keyFile)) {
  const cert = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      // Keep the public-key pin stable when renewing the local certificate.
      ...(existsSync(keyFile) ? ['-key', keyFile] : ['-newkey', 'rsa:2048']),
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '30',
      '-subj',
      `/CN=${app.hostname}`,
      '-addext',
      `subjectAltName=DNS:${app.hostname}`,
    ],
    { stdio: 'pipe' },
  );
  if (cert.status !== 0)
    throw new Error('Could not generate the local HTTPS certificate with openssl.');
  chmodSync(keyFile, 0o600);
  chmodSync(certFile, 0o600);
}
const certificate = new X509Certificate(readFileSync(certFile));
if (!certificate.checkHost(app.hostname))
  throw new Error('The saved local certificate belongs to another app host.');
const pin = createHash('sha256')
  .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const chromeArgs = [
  `--user-data-dir=${profile}`,
  `--host-resolver-rules=MAP ${app.hostname}:443 127.0.0.1:${port}`,
  `--ignore-certificate-errors-spki-list=${pin}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  `${app.origin}/dashboard`,
];

function openBrowser() {
  const browser = spawn(chrome, chromeArgs, { detached: true, stdio: 'ignore' });
  browser.on('error', () =>
    console.error('Could not open Chrome. Set LIVE_CONSOLE_CHROME to its executable.'),
  );
  browser.unref();
}

// Verify this exact local server using its certificate; no global TLS verification changes.
async function ready() {
  return new Promise((resolveReady) => {
    const request = https.get(
      {
        hostname: '127.0.0.1',
        port,
        servername: app.hostname,
        path: '/login',
        headers: { Host: app.hostname },
        ca: readFileSync(certFile),
        timeout: 5000,
      },
      (response) => {
        response.resume();
        resolveReady(
          response.statusCode === 200 && response.headers['x-tendr-local-live-console'] === '1',
        );
      },
    );
    request.on('error', () => resolveReady(false));
    request.on('timeout', () => request.destroy());
  });
}

if (process.argv.includes('--open')) {
  if (!(await ready())) throw new Error('Start npm run dev:console:live first.');
  openBrowser();
} else {
  await new Promise((resolvePort, reject) => {
    const socket = net.createServer();
    socket.once('error', () =>
      reject(new Error(`Port ${port} is in use. Use --open for an existing live console.`)),
    );
    socket.listen(port, '127.0.0.1', () => socket.close(resolvePort));
  });
  // Only web settings and normal OS runtime variables reach Next. Root .env is not loaded.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TMPDIR',
        'TMP',
        'TEMP',
        'LANG',
        'LC_ALL',
        'TERM',
        'SYSTEMROOT',
      ].includes(name),
    ),
  );
  for (const name of [
    'WEB_INTERNAL_TOKEN',
    'NEXT_PUBLIC_REOWN_PROJECT_ID',
    'NEXT_PUBLIC_EVM_FORWARDER_ADDRESS',
    'NEXT_PUBLIC_TRON_FORWARDER_ADDRESS',
    'NEXT_PUBLIC_GAS_FEE_RECIPIENTS',
    'TENDR_ASSET_ORIGIN',
  ])
    if (typeof config[name] === 'string') env[name] = config[name];
  Object.assign(env, {
    NODE_ENV: 'development',
    TENDR_SKIP_DOTENV: '1',
    LOCAL_LIVE_CONSOLE: 'true',
    API_CONSOLE_ENABLED: 'true',
    API_BASE_URL: api.origin,
    NEXT_PUBLIC_API_BASE_URL: api.origin,
    NEXT_PUBLIC_WEBAUTHN_RP_ID: rpId,
    WEB_URL: app.origin,
    CHECKOUT_BASE_URL: checkout.origin,
    MAIL_DRIVER: 'resend',
    NEXT_TELEMETRY_DISABLED: '1',
  });
  for (const args of [
    ['run', 'build', '-w', '@tendr/contracts'],
    ['run', 'predev', '-w', '@tendr/web'],
  ]) {
    const result = spawnSync('npm', args, { cwd: root, env, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const child = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--experimental-https',
      '--experimental-https-key',
      keyFile,
      '--experimental-https-cert',
      certFile,
    ],
    { cwd: resolve(root, 'apps/web'), env, stdio: 'inherit' },
  );
  let stopped = false;
  function stop() {
    stopped = true;
    child.kill('SIGTERM');
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('error', () => {
    stopped = true;
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    stopped = true;
    process.exitCode = code ?? 0;
  });
  const deadline = Date.now() + 120_000;
  while (!stopped && Date.now() < deadline && !(await ready()))
    await new Promise((r) => setTimeout(r, 500));
  if (!stopped && Date.now() < deadline) {
    console.log(`Local dashboard: ${app.origin}/dashboard (use the dedicated Chrome window)`);
    console.log(
      `Live API: ${api.origin} · Live mode uses real funds · server bound to 127.0.0.1:${port}`,
    );
    if (!process.argv.includes('--no-browser')) openBrowser();
  } else if (!stopped) {
    stop();
    process.exitCode = 1;
    console.error('Local live console did not become ready.');
  }
}
