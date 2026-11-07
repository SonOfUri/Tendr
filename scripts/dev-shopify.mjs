import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, '.keyvault/shopify-simulator');
const envFile = resolve(directory, 'docker.env');
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (!existsSync(envFile))
  writeFileSync(
    envFile,
    `TENDR_SHOPIFY_SIMULATOR_STORAGE_KEY=${randomBytes(32).toString('hex')}\n`,
    { mode: 0o600 },
  );
if (!/^TENDR_SHOPIFY_SIMULATOR_STORAGE_KEY=[a-f0-9]{64}\s*$/.test(readFileSync(envFile, 'utf8')))
  throw new Error('Invalid simulator storage configuration');
const args = [
  'compose',
  '--env-file',
  envFile,
  '-f',
  resolve(root, 'infra/docker/shopify-compose.yml'),
];
const action = process.argv[2] || 'up';
if (!['up', 'stop', 'logs'].includes(action))
  throw new Error('Usage: npm run dev:shopify -- [up|stop|logs]');
args.push(
  ...(action === 'up'
    ? ['up', '-d', '--build', '--wait']
    : action === 'stop'
      ? ['stop']
      : ['logs', '--tail', '60']),
);
const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) process.exit(result.status || 1);
if (action === 'up')
  console.log(
    'Shopify connector simulator: http://localhost:3355\nNo Shopify account or real funds are used.',
  );
