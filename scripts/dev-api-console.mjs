// Isolated local testing: fake NEAR must share a process between API and worker.
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const env = { ...process.env };
const database = new URL(
  env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:15432/tendr',
);
const redis = new URL(env.REDIS_URL ?? 'redis://localhost:6380');
for (const url of [database, redis]) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error(
      'The local console launcher requires localhost Postgres and Redis. Use a separately configured deployment for remote services.',
    );
}
database.pathname = '/tendr_api_console';
redis.pathname = '/8';
const webPort = Number(env.API_CONSOLE_WEB_PORT ?? 3300);
const apiPort = Number(env.API_CONSOLE_API_PORT ?? 4300);
if (
  ![webPort, apiPort].every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535) ||
  webPort === apiPort
)
  throw new Error('Choose distinct valid console web/API ports.');
const web = `http://localhost:${webPort}`;
const api = `http://localhost:${apiPort}`;
Object.assign(env, {
  NODE_ENV: 'development',
  API_CONSOLE_ENABLED: 'true',
  TENDR_SKIP_DOTENV: '1',
  DATABASE_URL: database.href,
  TEST_DATABASE_URL: database.href,
  REDIS_URL: redis.href,
  API_HOST: '127.0.0.1',
  API_PORT: String(apiPort),
  API_BASE_URL: api,
  NEXT_PUBLIC_API_BASE_URL: api,
  WEB_URL: web,
  CHECKOUT_BASE_URL: web,
  TENDR_CHECKOUT_BASE_URL: web,
  CORS_ORIGINS: web,
  WEBAUTHN_RP_ID: 'localhost',
  NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGINS: web,
  MAIL_DRIVER: 'log',
  FX_PROVIDER: 'fixed',
  KEYVAULT_DRIVER: 'local',
  LOCAL_KEYVAULT_PATH: resolve(root, '.keyvault/api-console.json'),
  API_CONSOLE_STATE_PATH: resolve(root, '.keyvault/api-console-state.bin'),
  LIVE_ACCOUNT_DRIVER: 'native_intents',
  SCREENING_MODE: 'disabled',
  NEAR_CLIENT_DRIVER: 'fake',
  NEAR_FAKE_SIMULATE: '1',
  MERCHANT_ACCOUNT_CODE_HASH_TEST: '11111111111111111111111111111111',
  MERCHANT_ACCOUNT_CODE_HASH_LIVE: '11111111111111111111111111111111',
  LIVE_MODE_ENABLED: 'false',
  GASLESS_LIVE_ENABLED: 'false',
  FEE_SWEEP_ENABLED: 'false',
  ASSET_STORE_DRIVER: 'memory',
  ASSET_PUBLIC_PROXY: 'true',
  TENDR_ASSET_ORIGIN: `${api}/v1/assets`,
  NEXT_PUBLIC_REOWN_PROJECT_ID: '',
  NEXT_PUBLIC_E2E_INJECTED_WALLET: '',
  WEB_INTERNAL_TOKEN: 'local-api-console-internal-token-not-for-deployment',
  LOG_LEVEL: 'warn',
});
// Never forward production provider/vault credentials into the local fake stack.
for (const key of [
  'RESEND_API_KEY',
  'ONECLICK_API_KEY',
  'FX_API_KEY',
  'CHAINALYSIS_API_KEY',
  'ENV_KEYVAULT_JSON',
  'GCP_CREDENTIALS_JSON',
  'ASSET_S3_ACCESS_KEY_ID',
  'ASSET_S3_SECRET_ACCESS_KEY',
  'TENDR_SECRET_KEY_TEST',
  'DATABASE_MIGRATE_URL',
  'DATABASE_APP_PASSWORD',
  'SEED_PAYOUT_ADDRESS',
])
  delete env[key];

function run(args, cwd = root) {
  const result = spawnSync('npm', args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['run', 'build', '--workspace=@tendr/contracts']);
run(['run', 'db:generate']);
run(['run', 'db:migrate:test', '--workspace=@tendr/api']);
if (process.argv.includes('--seed')) {
  // Existing seed prints newly created test keys once, in the user's own terminal.
  const seeded = spawnSync(process.execPath, ['--import', 'tsx', 'prisma/seed.ts'], {
    cwd: resolve(root, 'apps/api'),
    env,
    stdio: 'inherit',
  });
  process.exit(seeded.status ?? 1);
}
run(['run', 'predev', '--workspace=@tendr/web']);
console.log(
  `API console: ${web}/settings/api-console\nLocal database: tendr_api_console · Redis DB 8 · no real money\nRun npm run console:seed in another terminal for demo API keys. Email links appear in apps/api/.mail/.`,
);
const processes = [
  spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e-server.ts'], {
    cwd: resolve(root, 'apps/api'),
    env,
    stdio: 'inherit',
  }),
  spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    { cwd: resolve(root, 'apps/web'), env, stdio: 'inherit' },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of processes) {
  child.on('error', () => stop(1));
  child.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
