// WooCommerce e2e global setup: build the plugin zip, then give each WordPress site a fresh
// database (WordPress + WooCommerce only; the plugin is installed by the spec, from the zip, through
// the admin's "Upload Plugin" page) with what a store owner would have set up: pretty permalinks,
// the store open, a US address, Cash on delivery as a second payment method, and two virtual products.
import { execFileSync } from 'node:child_process';
import { SITES, WOO_DIR, wp, wpEnv, wpPhp, wpSql, type SiteId } from './wp';

export const PRODUCT_USD = { name: 'E2E Mug', price: '10.00' };
/** 16,000 NGN = $10.00 at the API's fixed test rate (1 USD = 1600 NGN). */
export const PRODUCT_NGN = { name: 'E2E Kettle', price: '16000' };

function prepare(site: SiteId): void {
  wpEnv(site, ['start']);
  // An earlier run's upload stays in wp-content (the database reset below does not touch files).
  try {
    wp(site, ['plugin', 'delete', 'tendr-pay-with-crypto']);
  } catch {
    // Not installed.
  }
  wpEnv(site, ['clean', 'development']);

  wp(site, ['rewrite', 'structure', '/%postname%/', '--hard']);
  // `wp option update woocommerce_coming_soon` can hang (WooCommerce does remote work on it).
  wpSql(
    site,
    "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('woocommerce_coming_soon', 'no', 'on') ON DUPLICATE KEY UPDATE option_value = 'no'",
  );
  // One PHP run sets every option (`update_option` returns false for an unchanged value, which
  // `wp option update` reports as a failure).
  wpPhp(
    site,
    `
    update_option('woocommerce_default_country', 'US:CA');
    update_option('woocommerce_currency', 'USD');
    update_option('woocommerce_task_list_hidden', 'yes');
    update_option('woocommerce_allow_tracking', 'no');
    update_option('woocommerce_show_marketplace_suggestions', 'no');
    update_option('woocommerce_enable_guest_checkout', 'yes');
    update_option('woocommerce_onboarding_profile', array('skipped' => true));
    update_option('woocommerce_cod_settings', array('enabled' => 'yes', 'title' => 'Cash on delivery', 'enable_for_virtual' => 'yes'));
    // WooCommerce's "first order" celebration overlay would cover the order screen.
    update_user_meta(1, '_wc_egg_opted_out', '1');
    `,
  );
  for (const p of [PRODUCT_USD, PRODUCT_NGN]) {
    wp(site, [
      'wc',
      'product',
      'create',
      '--user=admin',
      `--name=${p.name}`,
      '--type=simple',
      `--regular_price=${p.price}`,
      '--virtual=true',
      '--status=publish',
      '--porcelain',
    ]);
  }
}

export default async function globalSetup(): Promise<void> {
  const out = execFileSync('node', ['scripts/build-zip.mjs', '--no-publish'], {
    cwd: WOO_DIR,
    encoding: 'utf8',
  });
  const built = JSON.parse(out.trim().split('\n').at(-1)!) as { path: string; sha256: string };
  process.env.TENDR_E2E_ZIP = built.path;
  process.env.TENDR_E2E_ZIP_SHA256 = built.sha256;
  for (const site of Object.keys(SITES) as SiteId[]) prepare(site);
}
