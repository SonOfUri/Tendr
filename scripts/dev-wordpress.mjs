// Persistent local WordPress + WooCommerce, pointed at the real Tendr service.
// Secrets stay in .keyvault. A public HTTPS tunnel is needed before using Connect.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.umask(0o077);
const privateDir = resolve(root, '.keyvault/wordpress-store');
const credentialsPath = resolve(privateDir, 'credentials.json');
const envPath = resolve(privateDir, 'compose.env');
mkdirSync(privateDir, { recursive: true, mode: 0o700 });

if (!existsSync(credentialsPath)) {
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        siteUrl: 'http://localhost:8894',
        username: 'tendradmin',
        password: randomBytes(24).toString('base64url'),
        dbPassword: randomBytes(32).toString('hex'),
        dbRootPassword: randomBytes(32).toString('hex'),
      },
      null,
      2,
    ) + '\n',
  );
}
chmodSync(credentialsPath, 0o600);
const saved = JSON.parse(readFileSync(credentialsPath, 'utf8'));
writeFileSync(
  envPath,
  `WPSTORE_DB_PASSWORD=${saved.dbPassword}\nWPSTORE_DB_ROOT_PASSWORD=${saved.dbRootPassword}\n`,
  { mode: 0o600 },
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status}).`);
  return result;
}
const composeArgs = ['compose', '--env-file', envPath, '-f', 'infra/docker/wordpress-compose.yml'];
const compose = (args, options) => run('docker', [...composeArgs, ...args], options);
const wp = (...args) => compose(['run', '--rm', '-T', 'cli', 'wp', ...args]);

if (process.argv.includes('--stop')) {
  compose(['stop']);
  console.log(
    'WordPress stopped; its database and files are retained. Stop any tunnel separately.',
  );
} else if (process.argv.includes('--url')) {
  const url = new URL(process.argv[process.argv.indexOf('--url') + 1]);
  if (
    (url.protocol !== 'https:' && url.origin !== 'http://localhost:8894') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use a plain HTTPS origin, or http://localhost:8894 for local-only access.');
  wp('option', 'update', 'home', url.origin);
  wp('option', 'update', 'siteurl', url.origin);
  wp('rewrite', 'flush', '--hard');
  saved.siteUrl = url.origin;
  writeFileSync(credentialsPath, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  console.log(`Store URL updated: ${url.origin}. Reconnect Tendr if the site address changed.`);
} else {
  run('node', ['apps/woocommerce/scripts/build-zip.mjs', '--no-publish']);
  compose(['up', '-d', '--wait', 'db', 'wordpress']);
  const installed = spawnSync(
    'docker',
    [...composeArgs, 'run', '--rm', '-T', 'cli', 'wp', 'core', 'is-installed'],
    { cwd: root, stdio: 'ignore' },
  );
  if (installed.status !== 0) {
    // WP-CLI echoes prompted values. Keep both output streams private as well as using stdin.
    compose(
      [
        'run',
        '--rm',
        '-T',
        'cli',
        'wp',
        'core',
        'install',
        `--url=${saved.siteUrl}`,
        '--title=Tendr Demo Store',
        `--admin_user=${saved.username}`,
        '--admin_email=admin@example.invalid',
        '--skip-email',
        '--prompt=admin_password',
      ],
      { input: saved.password + '\n', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    console.log('WordPress installed; generated admin credentials saved privately.');
  }
  wp('plugin', 'install', 'woocommerce', '--version=11.2.1', '--activate');
  const { version } = JSON.parse(
    readFileSync(resolve(root, 'apps/woocommerce/package.json'), 'utf8'),
  );
  wp(
    'plugin',
    'install',
    `/opt/tendr-dist/tendr-pay-with-crypto-${version}.zip`,
    '--activate',
    '--force',
  );
  wp('theme', 'install', 'storefront');
  if (installed.status !== 0) wp('theme', 'activate', 'storefront');
  wp('rewrite', 'structure', '/%postname%/', '--hard');
  wp('eval-file', '/opt/tendr-setup.php');
  console.log(`Store: ${saved.siteUrl}\nAdmin: ${saved.siteUrl}/wp-admin/`);
  console.log(`Username: ${saved.username}\nPassword saved privately in ${credentialsPath}`);
  console.log(
    'Connect requires public HTTPS. See docs/wordpress-store.md for the tunnel and account approval.',
  );
}
