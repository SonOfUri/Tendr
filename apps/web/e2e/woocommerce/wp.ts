// The two WordPress sites of the WooCommerce e2e (wp-env, apps/woocommerce/.wp-env.e2e*.json) and
// WP-CLI inside them. WP-CLI is only the test's back door: it prepares the sites and reads state a
// person would see in the admin; the plugin itself is installed, connected and used through the
// browser.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const WOO_DIR = resolve(__dirname, '../../../woocommerce');

export const SITES = {
  a: { config: '.wp-env.e2e.json', url: 'http://localhost:8892' },
  b: { config: '.wp-env.e2e-b.json', url: 'http://localhost:8893' },
} as const;
export type SiteId = keyof typeof SITES;

export const WP_ADMIN = { user: 'admin', password: 'password' };
export const PLUGIN = 'tendr-pay-with-crypto';

/** `npx wp-env <args>` for a site; returns stdout (wp-env's own status lines go to stderr). */
export function wpEnv(site: SiteId, args: string[], timeout = 600_000): string {
  // `--config` goes right after the subcommand: anything after `--` is the container's command.
  const [command, ...rest] = args;
  return execFileSync('npx', ['wp-env', command!, `--config=${SITES[site].config}`, ...rest], {
    cwd: WOO_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

/** WP-CLI in the site's cli container. */
export function wp(site: SiteId, args: string[]): string {
  return wpEnv(site, ['run', 'cli', '--', 'wp', ...args], 180_000).trim();
}

/** Runs PHP in WordPress (`wp eval`), passed base64-encoded so no quoting reaches a shell. */
export function wpPhp(site: SiteId, php: string): string {
  const b64 = Buffer.from(php, 'utf8').toString('base64');
  return wp(site, ['eval', `eval(base64_decode('${b64}'));`]);
}

/** A database query's rows, as `wp db query` prints them (tab-separated, no header). */
export function wpSql(site: SiteId, sql: string): string[][] {
  const out = wp(site, ['db', 'query', sql, '--skip-column-names']);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('\t'));
}
