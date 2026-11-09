// Apply the local fashion demo without changing the Tendr connection or paying an order.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.keyvault/wordpress-store/compose.env');
if (!existsSync(envFile)) throw new Error('Start the store with npm run dev:wordpress first.');
const compose = ['compose', '--env-file', envFile, '-f', 'infra/docker/wordpress-compose.yml'];
function run(args) {
  const result = spawnSync('docker', [...compose, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not apply the fashion concept.');
}
run(['up', '-d', '--wait', 'db', 'wordpress']);
run(['run', '--rm', '-T', 'cli', 'wp', 'eval-file', '/opt/tendr-fashion-setup.php']);
